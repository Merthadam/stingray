def route_after_plan(state):
    """Retry a plan when validation requests it."""
    if state.get("retry"):
        return "retry"
    return "done"
