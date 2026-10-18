export default `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(method_invocation !object name: (identifier) @name) @call
(method_invocation object: (_) @receiver name: (identifier) @name) @call.member
(field_declaration type: (type_identifier) @decl.type declarator: (variable_declarator name: (identifier) @decl.name))
(local_variable_declaration type: (type_identifier) @decl.type declarator: (variable_declarator name: (identifier) @decl.name))
(formal_parameter type: (type_identifier) @decl.type name: (identifier) @decl.name)
(object_creation_expression type: (type_identifier) @name) @call
(import_declaration (scoped_identifier) @source)
`;
