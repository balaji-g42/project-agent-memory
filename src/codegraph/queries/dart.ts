export default `
(class_definition name: (identifier) @name) @definition.class
(mixin_declaration (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(extension_declaration class: (type_identifier) @name) @container
(function_signature name: (identifier) @name) @definition.function
((identifier) @name . (selector (argument_part)) @call)
((selector (unconditional_assignable_selector (identifier) @name)) . (selector (argument_part)) @call.member)
((selector (conditional_assignable_selector (identifier) @name)) . (selector (argument_part)) @call.member)
((identifier) @receiver . (selector [(unconditional_assignable_selector (identifier) @name) (conditional_assignable_selector (identifier) @name)]) . (selector (argument_part)) @call.member)
(declaration (type_identifier) @decl.type (initialized_identifier_list (initialized_identifier . (identifier) @decl.name)))
(formal_parameter (type_identifier) @decl.type name: (identifier) @decl.name)
(initialized_variable_definition (type_identifier) @decl.type name: (identifier) @decl.name)
(initialized_variable_definition name: (identifier) @decl.name . value: (identifier) @decl.type . value: (selector (argument_part)) (#match? @decl.type "^[A-Z]"))
(library_import (import_specification (configurable_uri (uri (string_literal) @source))))
`;
