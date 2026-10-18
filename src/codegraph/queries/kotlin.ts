export default `
(class_declaration name: (identifier) @name) @definition.class
(object_declaration name: (identifier) @name) @definition.class
(function_declaration name: (identifier) @name) @definition.function
(call_expression . (identifier) @name) @call
(call_expression . (navigation_expression . (_) @receiver (identifier) @name .)) @call.member
(class_parameter (identifier) @decl.name [(user_type . (identifier) @decl.type) (nullable_type (user_type . (identifier) @decl.type))])
(variable_declaration (identifier) @decl.name [(user_type . (identifier) @decl.type) (nullable_type (user_type . (identifier) @decl.type))])
(parameter (identifier) @decl.name [(user_type . (identifier) @decl.type) (nullable_type (user_type . (identifier) @decl.type))])
(property_declaration (variable_declaration . (identifier) @decl.name .) (call_expression . (identifier) @decl.type) (#match? @decl.type "^[A-Z]"))
(import (qualified_identifier) @source)
`;
