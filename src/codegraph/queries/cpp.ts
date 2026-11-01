export default `
(class_specifier name: (type_identifier) @name body: (_)) @definition.class
(struct_specifier name: (type_identifier) @name body: (_)) @definition.class
(union_specifier name: (type_identifier) @name body: (_)) @definition.class
(enum_specifier name: (type_identifier) @name body: (_)) @definition.enum
(function_definition declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name)) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: [(identifier) (field_identifier)] @name))) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (namespace_identifier) @scope name: (identifier) @name))) @definition.method
(function_definition declarator: (function_declarator declarator: (qualified_identifier name: (qualified_identifier scope: (namespace_identifier) @scope name: (identifier) @name)))) @definition.method
(call_expression function: (identifier) @name) @call
(call_expression function: (field_expression argument: (_) @receiver field: (field_identifier) @name)) @call.member
(call_expression function: (qualified_identifier name: (identifier) @name)) @call
(preproc_include path: (string_literal (string_content) @source))
`;
