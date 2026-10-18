export default `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(call function: (identifier) @name) @call
(call function: (attribute attribute: (identifier) @name)) @call
(import_statement name: (dotted_name) @source)
(import_statement name: (aliased_import name: (dotted_name) @source))
(import_from_statement module_name: (_) @source)
`;
