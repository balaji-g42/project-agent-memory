export default `
(struct_specifier name: (type_identifier) @name body: (_)) @definition.class
(union_specifier name: (type_identifier) @name body: (_)) @definition.class
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(call_expression function: (identifier) @name) @call
(call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @name)) @call.member
(preproc_include path: (string_literal (string_content) @source))
`;
