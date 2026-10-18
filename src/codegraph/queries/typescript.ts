import { base, jsx } from "./javascript.js";

const typescript = base + `
(abstract_class_declaration name: (type_identifier) @name) @definition.class
(interface_declaration name: (type_identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(abstract_method_signature name: (property_identifier) @name) @definition.method
(required_parameter pattern: (identifier) @decl.name type: (type_annotation (type_identifier) @decl.type))
(public_field_definition name: (property_identifier) @decl.name type: (type_annotation (type_identifier) @decl.type))
(variable_declarator name: (identifier) @decl.name type: (type_annotation (type_identifier) @decl.type))
`;

export const tsx = typescript + jsx;

export default typescript;
