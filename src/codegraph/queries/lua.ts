export default `
(function_declaration name: (identifier) @name) @definition.function
(function_declaration name: (dot_index_expression table: (identifier) @scope field: (identifier) @name)) @definition.method
(function_declaration name: (method_index_expression table: (identifier) @scope method: (identifier) @name)) @definition.method
(function_call name: (identifier) @name) @call
(function_call name: (dot_index_expression table: (_) @receiver field: (identifier) @name)) @call.member
(function_call name: (method_index_expression table: (_) @receiver method: (identifier) @name)) @call.member
`;
