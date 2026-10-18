export default `
(class_declaration name: (type_identifier) @name) @definition.class
(class_declaration name: (user_type (type_identifier) @name)) @container
(protocol_declaration name: (type_identifier) @name) @definition.interface
(function_declaration name: (simple_identifier) @name) @definition.function
(protocol_function_declaration name: (simple_identifier) @name) @definition.function
(call_expression . (simple_identifier) @name) @call
(call_expression . (navigation_expression suffix: (navigation_suffix suffix: (simple_identifier) @name))) @call.member
`;
