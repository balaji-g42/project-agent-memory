export default `
(class_definition name: (identifier) @name) @definition.class
(mixin_declaration (identifier) @name) @definition.class
(enum_declaration name: (identifier) @name) @definition.enum
(extension_declaration class: (type_identifier) @name) @container
(function_signature name: (identifier) @name) @definition.function
((identifier) @name . (selector (argument_part)) @call)
((selector (unconditional_assignable_selector (identifier) @name)) . (selector (argument_part)) @call.member)
((selector (conditional_assignable_selector (identifier) @name)) . (selector (argument_part)) @call.member)
(library_import (import_specification (configurable_uri (uri (string_literal) @source))))
`;
