import javascript from "./javascript.js";

export default javascript + `
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(abstract_method_signature name: (property_identifier) @name) @definition.method
`;
