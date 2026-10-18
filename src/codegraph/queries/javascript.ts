export default `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
((method_definition name: (_) @name) @definition.method (#not-eq? @name "constructor"))
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(call_expression function: (identifier) @name) @call
(call_expression function: (member_expression property: (property_identifier) @name)) @call
(new_expression constructor: (identifier) @name) @call
(import_statement source: (string (string_fragment) @source))
(export_statement source: (string (string_fragment) @source))
((call_expression function: (identifier) @_fn arguments: (arguments . (string (string_fragment) @source))) (#eq? @_fn "require"))
`;
