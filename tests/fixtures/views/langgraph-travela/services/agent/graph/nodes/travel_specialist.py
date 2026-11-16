"""Private topic subflow, invoked through the existing Plan graph.

The parent graph receives only the bounded turn result. Own-topic history and
the saved Canvas are mapped into a separate, non-checkpointed subgraph state.
"""
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph

from ...request_context import (current_authorization_token, current_specialist_input,
                                current_text_delta_callback, current_workspace_context)
from ...turn import TurnContext


class SpecialistState(TypedDict):
    message: str
    topic: str
    context: Any
    brief: dict
    notes: Any
    saved_canvas: dict | None
    saved_research: dict
    selected_context: Any
    result: dict


class TravelSpecialistNode:
    def __init__(self, adapter):
        self.adapter = adapter
        flow = StateGraph(SpecialistState)
        flow.add_node("research", self._research)
        flow.add_edge(START, "research")
        flow.add_edge("research", END)
        self.subflow = flow.compile(checkpointer=False)

    async def _research(self, state):
        from ...claude.travel_specialist import ClaudeSdkTravelSpecialist
        specialist = ClaudeSdkTravelSpecialist(self.adapter.config, worker=getattr(self.adapter, "worker", None))
        result = await specialist.complete(
            message=state["message"], topic=state["topic"], context=state["context"],
            brief=state["brief"], notes=state["notes"], saved_canvas=state["saved_canvas"],
            saved_research=state["saved_research"],
            selected_context=state.get("selected_context"),
            workspace_context=current_workspace_context(),
            authorization_token=current_authorization_token() or "",
            on_text_delta=current_text_delta_callback(),
        )
        return {"result": result}

    async def __call__(self, state):
        if getattr(self.adapter, "config", None) is None:
            return {"status": "unable to continue", "error": "Travel discussion is unavailable."}
        private = current_specialist_input()
        context = TurnContext(
            traveler_scope=state["traveler_scope"], plan_id=state["plan_id"],
            conversation_id=private.get("conversation_id"),
            plan_revision=state.get("plan_revision", 1), generation=state.get("generation", 0),
            recent_messages=tuple(private.get("messages", [])[-12:]),
        )
        result = (await self.subflow.ainvoke({
            "message": state["message"], "topic": state["topic"], "context": context,
            "brief": private.get("brief", {}), "notes": private.get("notes", []),
            "saved_canvas": private.get("saved_canvas"),
            "saved_research": {name: private.get(name) for name in ("comparison", "shortlist", "preferred")},
            "selected_context": private.get("selected_context"),
        }))["result"]
        # Never return the child state, private transcript or SDK session to Trip.
        return {name: result[name] for name in ("status", "assistant_text", "question", "error", "travel_specialist_result") if name in result}
