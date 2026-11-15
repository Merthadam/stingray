from langgraph.graph import END, START, StateGraph

from .nodes import ConversationNode, plan_node, route_after_plan
from .state import AgentState


def build_graph(adapter):
    builder = StateGraph(AgentState)
    builder.add_node("chat", ConversationNode(adapter))
    builder.add_node("plan", plan_node)
    builder.add_node(summarize)
    builder.add_conditional_edges(
        START,
        lambda state: "plan" if state.get("needs_plan") else "chat",
        {"plan": "plan", "chat": "chat"},
    )
    builder.add_conditional_edges("plan", route_after_plan, {"done": "summarize", "retry": "plan"})
    builder.add_edge("chat", END)
    builder.add_edge("summarize", END)
    return builder.compile()


def summarize(state):
    return state
