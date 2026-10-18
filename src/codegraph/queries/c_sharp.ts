export default `
(class_declaration name: (identifier) @name) @definition.class
(struct_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(invocation_expression function: (identifier) @name) @call
(invocation_expression function: (member_access_expression expression: (_) @receiver name: (identifier) @name)) @call.member
(variable_declaration type: (identifier) @decl.type (variable_declarator name: (identifier) @decl.name))
(parameter type: (identifier) @decl.type name: (identifier) @decl.name)
(object_creation_expression type: (identifier) @name) @call
`;
