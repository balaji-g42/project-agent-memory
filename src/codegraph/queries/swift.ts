export default `
(class_declaration name: (type_identifier) @name) @definition.class
(class_declaration name: (user_type (type_identifier) @name)) @container
(protocol_declaration name: (type_identifier) @name) @definition.interface
(function_declaration name: (simple_identifier) @name) @definition.function
(protocol_function_declaration name: (simple_identifier) @name) @definition.function
(call_expression . (simple_identifier) @name) @call
(call_expression . (navigation_expression target: (_) @receiver suffix: (navigation_suffix suffix: (simple_identifier) @name))) @call.member
(property_declaration name: (pattern bound_identifier: (simple_identifier) @decl.name) (type_annotation [(user_type . (type_identifier) @decl.type) (optional_type (user_type . (type_identifier) @decl.type))]))
(parameter name: (simple_identifier) @decl.name . [(user_type . (type_identifier) @decl.type) (optional_type (user_type . (type_identifier) @decl.type))])
(property_declaration name: (pattern bound_identifier: (simple_identifier) @decl.name) value: (call_expression . (simple_identifier) @decl.type) (#match? @decl.type "^[A-Z]"))
`;
