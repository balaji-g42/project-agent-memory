export default `
(class_declaration name: (identifier) @name) @definition.class
(struct_declaration name: (identifier) @name) @definition.class
(record_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(method_declaration name: (identifier) @name) @definition.method
(invocation_expression function: (identifier) @name) @call
(invocation_expression function: (member_access_expression name: (identifier) @name)) @call
(object_creation_expression type: (identifier) @name) @call
`;
