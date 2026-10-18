export default `
(class_declaration name: (identifier) @name) @definition.class
(mixin_declaration name: (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(extension_type_declaration name: (extension_type_name (identifier) @name)) @definition.class
(extension_declaration class: (type (type_identifier) @name)) @container
(function_declaration signature: (function_signature name: (identifier) @name)) @definition.function
(method_declaration signature: (method_signature (function_signature name: (identifier) @name))) @definition.function
(declaration (function_signature name: (identifier) @name)) @definition.function
(local_function_declaration (function_signature name: (identifier) @name)) @definition.function
(call_expression function: (identifier) @name) @call
(call_expression function: (instantiation_expression function: (identifier) @name)) @call
(call_expression function: (function_expression body: (function_expression_body (identifier) @name))) @call
(call_expression function: [(member_expression property: (identifier) @name) (null_aware_member_expression property: (identifier) @name)]) @call.member
(call_expression function: (instantiation_expression function: [(member_expression property: (identifier) @name) (null_aware_member_expression property: (identifier) @name)])) @call.member
((call_expression function: [(member_expression object: (_) @receiver property: (identifier) @name) (null_aware_member_expression object: (_) @receiver property: (identifier) @name)]) @call.member (#not-match? @receiver "=>"))
(call_expression function: [(member_expression object: (function_expression body: (function_expression_body (_) @receiver)) property: (identifier) @name) (null_aware_member_expression object: (function_expression body: (function_expression_body (_) @receiver)) property: (identifier) @name)]) @call.member
(cascade_call_expression property: (identifier) @name) @call.member
(declaration (type (type_identifier) @decl.type) (initialized_identifier_list (initialized_identifier name: (identifier) @decl.name)))
(formal_parameter (type (type_identifier) @decl.type) name: (identifier) @decl.name)
(initialized_variable_definition (type (type_identifier) @decl.type) name: (identifier) @decl.name)
(initialized_variable_definition name: (identifier) @decl.name value: (call_expression function: (identifier) @decl.type) (#match? @decl.type "^[A-Z]"))
(initialized_identifier name: (identifier) @decl.name value: (call_expression function: (identifier) @decl.type) (#match? @decl.type "^[A-Z]"))
(import_specification uri: (configurable_uri (uri (string_literal) @source)))
`;
