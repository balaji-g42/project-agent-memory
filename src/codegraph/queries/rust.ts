export default `
(struct_item name: (type_identifier) @name) @definition.class
(union_item name: (type_identifier) @name) @definition.class
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.interface
(function_item name: (identifier) @name) @definition.function
(function_signature_item name: (identifier) @name) @definition.function
(impl_item type: (type_identifier) @name) @container
(impl_item type: (generic_type type: (type_identifier) @name)) @container
(call_expression function: (identifier) @name) @call
(call_expression function: (field_expression field: (field_identifier) @name)) @call.member
(call_expression function: (scoped_identifier name: (identifier) @name)) @call
`;
