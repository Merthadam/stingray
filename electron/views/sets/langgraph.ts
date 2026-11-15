// LangGraph StateGraph builders as a flow (view kind: flow). Node ids are scoped by file and graph variable
// ("<file>:<graph>:<name>"), so two graphs with a node of the same name stay apart; labels are the plain names.
const GRAPH_CALL = (methods: string) =>
  `function: (attribute object: (_) @graph attribute: (identifier) @m (#any-of? @m ${methods}))`;
// Alternations are kept flat: tree-sitter drops branches of an alternation nested directly in another one.
const KEY = '[(string (string_content) @key) (identifier) @key (true) @key (false) @key (integer) @key]';
const NAME = (capture: string) => `[(string (string_content) @${capture}) (identifier) @${capture}]`;

export const langgraph = String.raw`version: 1
name: langgraph
description: LangGraph StateGraph nodes, edges and conditional branches (kind flow)
rules:
  - id: graph
    language: python
    query: |
      (assignment left: (_) @graph
        right: (call function: [(identifier) @c (attribute attribute: (identifier) @c)] (#any-of? @c "StateGraph" "MessageGraph")))
    emit: { group: { id: "@file:@graph", label: "@graph (@file)" } }
  # add_node("name", handler) where handler is a function, an attribute or a call like ConversationNode(adapter).
  - id: step-handler
    language: python
    query: |
      (call ${GRAPH_CALL('"add_node"')}
        arguments: (argument_list . ${NAME('name')}
          . [(identifier) @fn (attribute attribute: (identifier) @fn)
             (call function: [(identifier) @fn (attribute attribute: (identifier) @fn)])] @handler))
    emit:
      node: { id: "@file:@graph:@name", label: "@name", kind: step, subtitle: "@fn", detail: "@handler", symbol: "@fn", group: "@file:@graph" }
  - id: step
    language: python
    query: |
      (call ${GRAPH_CALL('"add_node"')} arguments: (argument_list . ${NAME('name')} . (_)))
    emit: { node: { id: "@file:@graph:@name", label: "@name", kind: step, group: "@file:@graph" } }
  # add_node(handler): the node is named after the function.
  - id: step-function
    language: python
    query: |
      (call ${GRAPH_CALL('"add_node"')} arguments: (argument_list . (identifier) @name .))
    emit:
      node: { id: "@file:@graph:@name", label: "@name", kind: step, subtitle: "@name", symbol: "@name", group: "@file:@graph" }
  - id: start
    language: python
    query: |
      (call ${GRAPH_CALL('"add_edge" "add_conditional_edges"')} arguments: (argument_list . (identifier) @s (#eq? @s "START")))
      (call ${GRAPH_CALL('"set_entry_point" "set_conditional_entry_point"')})
    emit: { node: { id: "@file:@graph:START", label: START, kind: terminal, role: start, group: "@file:@graph" } }
  - id: end
    language: python
    query: |
      (call ${GRAPH_CALL('"add_edge"')} arguments: (argument_list (identifier) @e (#eq? @e "END")))
      (call ${GRAPH_CALL('"add_conditional_edges" "set_conditional_entry_point"')} arguments: (argument_list
        [(dictionary (pair value: (identifier) @e)) (list (identifier) @e)
         (keyword_argument value: [(dictionary (pair value: (identifier) @e)) (list (identifier) @e)])] (#eq? @e "END")))
      (call ${GRAPH_CALL('"set_finish_point"')})
    emit: { node: { id: "@file:@graph:END", label: END, kind: terminal, role: end, group: "@file:@graph" } }
  # add_edge(a, b) and add_edge([a, b], c) (c waits for both).
  - id: edge
    language: python
    query: |
      (call ${GRAPH_CALL('"add_edge"')}
        arguments: (argument_list . [(string (string_content) @from) (identifier) @from (list ${NAME('from')})] . ${NAME('to')}))
    emit: { edge: { from: "@file:@graph:@from", to: "@file:@graph:@to", kind: next } }
  - id: entry-point
    language: python
    query: |
      (call ${GRAPH_CALL('"set_entry_point"')} arguments: (argument_list . ${NAME('to')}))
    emit: { edge: { from: "@file:@graph:START", to: "@file:@graph:@to", kind: next } }
  - id: finish-point
    language: python
    query: |
      (call ${GRAPH_CALL('"set_finish_point"')} arguments: (argument_list . ${NAME('from')}))
    emit: { edge: { from: "@file:@graph:@from", to: "@file:@graph:END", kind: next } }
  # add_conditional_edges(source, router, {"label": target}) (path_map may be a keyword); the router may be a lambda.
  - id: branch
    language: python
    query: |
      (call ${GRAPH_CALL('"add_conditional_edges"')}
        arguments: (argument_list . ${NAME('from')}
          [(dictionary (pair key: ${KEY} value: ${NAME('to')}))
           (keyword_argument name: (identifier) @k (#eq? @k "path_map") value: (dictionary (pair key: ${KEY} value: ${NAME('to')})))]))
    emit: { edge: { from: "@file:@graph:@from", to: "@file:@graph:@to", kind: branch, label: "@key", certain: false } }
  - id: branch-list
    language: python
    query: |
      (call ${GRAPH_CALL('"add_conditional_edges"')}
        arguments: (argument_list . ${NAME('from')}
          [(list ${NAME('to')}) (keyword_argument name: (identifier) @k (#eq? @k "path_map") value: (list ${NAME('to')}))]))
    emit: { edge: { from: "@file:@graph:@from", to: "@file:@graph:@to", kind: branch, certain: false } }
  - id: entry-branch
    language: python
    query: |
      (call ${GRAPH_CALL('"set_conditional_entry_point"')}
        arguments: (argument_list
          [(dictionary (pair key: ${KEY} value: ${NAME('to')}))
           (keyword_argument name: (identifier) @k (#eq? @k "path_map") value: (dictionary (pair key: ${KEY} value: ${NAME('to')})))]))
    emit: { edge: { from: "@file:@graph:START", to: "@file:@graph:@to", kind: branch, label: "@key", certain: false } }
`;
