import { base, jsx } from "./javascript.js";

const typescript = base + `
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(abstract_method_signature name: (property_identifier) @name) @definition.method
`;

export const tsx = typescript + jsx;

export default typescript;
