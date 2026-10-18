export default `
(class_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(method_invocation name: (identifier) @name) @call
(object_creation_expression type: (type_identifier) @name) @call
(import_declaration (scoped_identifier) @source)
`;
