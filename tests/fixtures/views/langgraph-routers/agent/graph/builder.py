from langgraph.graph import START, StateGraph
from .nodes import route_after_plan as imported_route
import agent.graph.nodes as routers


def local_route(state):
    if state["topic"] not in ["stays", "flights"]:
        return "first"
    elif not state.canvas_edit and state.get("canvas_action"):
        return "second"
    else:
        return "last"


def ternary_route(state):
    return "a" if state.x or state["y"] else "b"


def repeated_route(state):
    if state.first:
        return "one"
    if state.second:
        return "two"
    return "last"


def dynamic_route(state):
    if state.x:
        return "first"
    return state.destination


flow = StateGraph(dict)
flow.add_node("a", handler)
flow.add_node("b", handler)
flow.add_node("c", handler)
flow.add_node("local", handler)
flow.add_node("imported", handler)
flow.add_node("module", handler)
flow.add_node("direct", handler)
flow.add_node("shared", handler)
flow.add_node("dynamic", handler)
flow.add_node("unmapped", handler)
flow.add_node("long", handler)
flow.add_conditional_edges("local", local_route, path_map={"first": "a", "second": "b", "last": "c"})
flow.add_conditional_edges("imported", imported_route, {"retry": "a", "done": "b"})
flow.add_conditional_edges("module", routers.route_after_plan, {"retry": "a", "done": "b"})
flow.add_conditional_edges("direct", ternary_route)
flow.add_conditional_edges("shared", repeated_route, {"one": "a", "two": "a", "last": "b"})
flow.add_conditional_edges("dynamic", dynamic_route, {"first": "a", "last": "b"})
flow.add_conditional_edges("unmapped", ternary_route, {"unused": "c"})
flow.add_conditional_edges("long", lambda state: "a" if state.get("a_very_long_condition_name_that_exceeds_the_sixty_character_label_limit") else "b")
flow.set_conditional_entry_point(ternary_route, {"a": "local", "b": "imported"})
