export default `
(class_definition name: (identifier) @name) @definition.class
(function_definition name: (identifier) @name) @definition.function
(call function: (identifier) @name) @call
(call function: (attribute object: (_) @receiver attribute: (identifier) @name)) @call.member
(import_statement name: (dotted_name) @source)
(import_statement name: (aliased_import name: (dotted_name) @source))
(import_from_statement module_name: (_) @source)
`;
