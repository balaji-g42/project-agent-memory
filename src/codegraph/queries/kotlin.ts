export default `
(class_declaration name: (identifier) @name) @definition.class
(object_declaration name: (identifier) @name) @definition.class
(function_declaration name: (identifier) @name) @definition.function
(call_expression . (identifier) @name) @call
(call_expression . (navigation_expression (identifier) @name .)) @call
(import (qualified_identifier) @source)
`;
