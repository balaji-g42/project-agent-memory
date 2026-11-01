export default `
(class_declaration name: (name) @name) @definition.class
(trait_declaration name: (name) @name) @definition.class
(interface_declaration name: (name) @name) @definition.interface
(enum_declaration name: (name) @name) @definition.enum
(function_definition name: (name) @name) @definition.function
(method_declaration name: (name) @name) @definition.method
(function_call_expression function: (name) @name) @call
(member_call_expression object: (_) @receiver name: (name) @name) @call.member
(scoped_call_expression scope: (_) @receiver name: (name) @name) @call.member
(object_creation_expression (name) @name) @call
`;
