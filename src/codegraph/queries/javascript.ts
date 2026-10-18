export const base = `
(function_declaration name: (identifier) @name) @definition.function
(generator_function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (_) @name) @definition.class
((method_definition name: (_) @name) @definition.method (#not-eq? @name "constructor"))
(lexical_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(variable_declaration (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @definition.function)
(program (lexical_declaration (variable_declarator name: (identifier) @name value: (call_expression)) @definition.function))
(program (export_statement (lexical_declaration (variable_declarator name: (identifier) @name value: (call_expression)) @definition.function)))
(call_expression function: (identifier) @name) @call
(call_expression function: (member_expression object: (_) @receiver property: (property_identifier) @name)) @call.member
(variable_declarator name: (identifier) @decl.name value: (new_expression constructor: (identifier) @decl.type))
(new_expression constructor: (identifier) @name) @call
(import_statement source: (string (string_fragment) @source))
(export_statement source: (string (string_fragment) @source))
((call_expression function: (identifier) @_fn arguments: (arguments . (string (string_fragment) @source))) (#eq? @_fn "require"))
`;

export const jsx = `
(jsx_opening_element name: (identifier) @name) @call
(jsx_self_closing_element name: (identifier) @name) @call
`;

export default base + jsx;
