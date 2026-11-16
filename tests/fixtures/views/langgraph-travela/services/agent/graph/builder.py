"""Assemble the small Plan-scoped LangGraph workflow."""

from __future__ import annotations

from typing import Any

from langgraph.graph import END, START, StateGraph

from ..request_context import (
    bind_workspace_context, reset_workspace_context,
    bind_workspace_update, reset_workspace_update,
    bind_specialist_input,
    reset_specialist_input,
    bind_travel_results,
    reset_travel_results,
    bind_authorization_token,
    bind_canvas_callback,
    bind_text_delta_callback,
    bind_traveler_profile,
    reset_authorization_token,
    reset_canvas_callback,
    reset_text_delta_callback,
    reset_traveler_profile,
)
from ..state import AgentState
from .nodes import ConversationNode
from .nodes.canvas_generation import CanvasGenerationNode
from .nodes.canvas_editing import CanvasEditingNode
from .nodes.travel_specialist import TravelSpecialistNode


class AgentGraph:
    """Stable graph interface: inject adapters, invoke with one Plan turn."""

    def __init__(self, adapter: Any, *, checkpointer: Any | None = None,
                 canvas_worker: Any | None = None) -> None:
        flow = StateGraph(AgentState)
        flow.add_node("chat", ConversationNode(adapter))
        flow.add_node("canvas_generation", CanvasGenerationNode(canvas_worker))
        flow.add_node("canvas_editing", CanvasEditingNode(adapter))
        flow.add_node("travel_specialist", TravelSpecialistNode(adapter))
        flow.add_conditional_edges(
            START,
            lambda state: "travel_specialist" if state.get("topic") in {"stays", "flights"} else "canvas_editing" if state.get("canvas_edit") else "canvas_generation" if state.get("canvas_action") else "chat",
            {"travel_specialist": "travel_specialist", "canvas_generation": "canvas_generation", "canvas_editing": "canvas_editing", "chat": "chat"},
        )
        flow.add_edge("chat", END)
        flow.add_edge("canvas_generation", END)
        flow.add_edge("canvas_editing", END)
        flow.add_edge("travel_specialist", END)
        self.compiled = flow.compile(checkpointer=checkpointer)

    async def invoke(
        self,
        state: AgentState,
        *,
        authorization_token: str | None = None,
        traveler_profile: dict[str, Any] | None = None,
        on_text_delta: Any | None = None,
        on_canvas_draft: Any | None = None,
        specialist_context: dict | None = None,
    ) -> dict[str, Any]:
        context_token = bind_authorization_token(authorization_token)
        profile_token = bind_traveler_profile(traveler_profile)
        text_token = bind_text_delta_callback(on_text_delta)
        canvas_token = bind_canvas_callback(on_canvas_draft)
        travel_results = []
        travel_token = bind_travel_results(travel_results)
        specialist_token = bind_specialist_input(specialist_context)
        workspace_token = bind_workspace_context((specialist_context or {}).get("workspace_context"))
        workspace_updates = []
        workspace_output_token = bind_workspace_update(workspace_updates)
        try:
            result = await self.compiled.ainvoke(state, config={"recursion_limit": 12})
        finally:
            reset_workspace_update(workspace_output_token)
            reset_workspace_context(workspace_token)
            reset_specialist_input(specialist_token)
            reset_travel_results(travel_token)
            reset_canvas_callback(canvas_token)
            reset_text_delta_callback(text_token)
            reset_traveler_profile(profile_token)
            reset_authorization_token(context_token)
        status = result.get("status", "unable to continue")
        projection: dict[str, Any] = {
            "status": status,
            "plan_id": result["plan_id"],
            "event_id": result["event_id"],
            "generation": result.get("generation", 0),
        }
        if state.get("canvas_action"):
            # A canvas request has no conversational or research output to project.
            if result.get("canvas_draft"):
                projection["canvas_draft"] = result.get("canvas_draft")
            if result.get("error"):
                projection["error"] = result["error"]
            return {**result, "projection": projection}
        if result.get("research_evidence"):
            # Preserve the citation identity for the API to validate against this
            # turn's successfully read evidence before reducing it to browser refs.
            sources = result.get("research_sources", [])
            evidence = {
                str(item.get("evidence_id")): item
                for item in result.get("research_evidence", [])
                if isinstance(item, dict)
                and item.get("read_status") == "read"
                and item.get("evidence_id")
            }
            cited_ids = set(result.get("research_evidence_ids", []))
            projection["sources"] = [
                {
                    "evidence_id": str(source.get("evidence_id")),
                    "title": source.get("title", ""),
                    "url": source.get("url", ""),
                }
                for source in sources[:3]
                if isinstance(source, dict)
                and str(source.get("evidence_id", "")) in cited_ids
                and str(source.get("evidence_id", "")) in evidence
            ] if isinstance(sources, list) else []
        for field in ("question", "assistant_text", "error", "canvas_edit_result", "travel_specialist_result"):
            if result.get(field):
                projection[field] = result[field]
        # Ephemeral provider snapshots never enter any compiled graph channel.
        if workspace_updates and state.get("topic") in {"stays", "flights"} and status in {"in_progress", "needs your input"}:
            projection["workspace_update"] = workspace_updates[-1]
        if travel_results and result.get("canvas_edit_result") and status in {"in_progress", "needs your input"}:
            projection["canvas_edit_result"] = {**result["canvas_edit_result"], "travel": travel_results}
        elif travel_results and result.get("research_flights") and status in {"in_progress", "needs your input"}:
            projection["flight_preview"] = next((item for item in travel_results if item["mode"] == "flights"), None)
        return {**result, "projection": projection}
