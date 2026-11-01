export default `
(class name: (constant) @name) @definition.class
(module name: (constant) @name) @definition.class
(method name: (identifier) @name) @definition.function
(singleton_method name: (identifier) @name) @definition.function
(call !receiver method: (identifier) @name) @call
(call receiver: (_) @receiver method: (identifier) @name) @call.member
(call !receiver method: (identifier) @_m arguments: (argument_list . (string (string_content) @source)) (#match? @_m "^require(_relative)?$"))
`;
