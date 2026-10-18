export default `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration
  receiver: (parameter_list (parameter_declaration type: [
    (type_identifier) @scope
    (pointer_type (type_identifier) @scope)
    (generic_type type: (type_identifier) @scope)
    (pointer_type (generic_type type: (type_identifier) @scope))
  ]))
  name: (field_identifier) @name) @definition.method
(type_spec name: (type_identifier) @name type: (struct_type)) @definition.class
(type_spec name: (type_identifier) @name type: (interface_type)) @definition.interface
(call_expression function: (identifier) @name) @call
(call_expression function: (selector_expression field: (field_identifier) @name)) @call.member
`;
