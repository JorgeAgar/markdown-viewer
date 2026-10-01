use std::{collections::BTreeMap, env, fs, path::PathBuf};

use heck::ToLowerCamelCase;
use syn::{
    parse::Parser, punctuated::Punctuated, visit::Visit, Attribute, Expr, FnArg, GenericArgument,
    Item, ItemFn, Meta, Pat, Path, PathArguments, ReturnType, Token, Type,
};

type Checked<T> = Result<T, String>;

fn name(path: &Path) -> String {
    path.segments
        .iter()
        .map(|s| s.ident.to_string())
        .collect::<Vec<_>>()
        .join("::")
}

// Fail closed: supporting a new serialization attribute requires extending the
// generator and its tests, rather than silently producing an inaccurate type.
fn attributes(attrs: &[Attribute], allowed: &[&str]) -> Checked<()> {
    for attr in attrs {
        if !allowed.contains(&name(attr.path()).as_str()) {
            return Err(format!("Unsupported IPC attribute: {}", name(attr.path())));
        }
    }
    Ok(())
}

fn type_arguments(ty: &Type) -> Checked<(String, Vec<&Type>)> {
    let Type::Path(ty) = ty else {
        return Err("Unsupported IPC type; extend the generator before using it".into());
    };
    if ty.qself.is_some() {
        return Err("Qualified IPC types are unsupported".into());
    }
    let mut args = Vec::new();
    for (index, segment) in ty.path.segments.iter().enumerate() {
        match &segment.arguments {
            PathArguments::None => (),
            PathArguments::AngleBracketed(arguments) if index + 1 == ty.path.segments.len() => {
                for arg in &arguments.args {
                    let GenericArgument::Type(ty) = arg else {
                        return Err("Non-type IPC generic arguments are unsupported".into());
                    };
                    args.push(ty);
                }
            }
            _ => return Err("Unsupported IPC type arguments".into()),
        }
    }
    Ok((name(&ty.path), args))
}

fn typescript(ty: &Type) -> Checked<String> {
    if matches!(ty, Type::Tuple(tuple) if tuple.elems.is_empty()) {
        return Ok("null".into());
    }
    let (name, args) = type_arguments(ty)?;
    match (name.as_str(), args.as_slice()) {
        ("String", []) => Ok("string".into()),
        ("bool", []) => Ok("boolean".into()),
        (
            "usize" | "u8" | "u16" | "u32" | "u64" | "isize" | "i8" | "i16" | "i32" | "i64" | "f32"
            | "f64",
            [],
        ) => Ok("number".into()),
        ("document::Document", []) => Ok("RenderedDocument".into()),
        ("Option", [inner]) => Ok(format!("{} | null", typescript(inner)?)),
        _ => Err(format!("Unsupported IPC type: {name}")),
    }
}

fn injected(ty: &Type) -> bool {
    let Type::Path(ty) = ty else { return false };
    if name(&ty.path) == "tauri::AppHandle" {
        return ty
            .path
            .segments
            .iter()
            .all(|s| matches!(s.arguments, PathArguments::None));
    }
    // The current State argument comes from Tauri, never from the JS payload.
    if name(&ty.path) == "State" {
        if let PathArguments::AngleBracketed(args) = &ty.path.segments[0].arguments {
            return matches!(args.args.iter().collect::<Vec<_>>().as_slice(),
                [GenericArgument::Lifetime(_), GenericArgument::Type(Type::Path(path))]
                if path.path.is_ident("Viewer"));
        }
    }
    false
}

fn command(function: &ItemFn) -> Checked<String> {
    attributes(&function.attrs, &["tauri::command", "doc"])?;
    let attribute = function
        .attrs
        .iter()
        .find(|a| {
            a.path()
                .segments
                .last()
                .is_some_and(|s| s.ident == "command")
        })
        .unwrap();
    if !matches!(attribute.meta, Meta::Path(_)) {
        return Err("tauri::command options are unsupported; extend the generator first".into());
    }
    if !function.sig.generics.params.is_empty() {
        return Err("Generic commands are unsupported".into());
    }
    let mut args = Vec::new();
    for arg in &function.sig.inputs {
        let FnArg::Typed(arg) = arg else {
            return Err("Command receivers are unsupported".into());
        };
        attributes(&arg.attrs, &[])?;
        if injected(&arg.ty) {
            continue;
        }
        let Pat::Ident(pattern) = &*arg.pat else {
            return Err("Command argument patterns are unsupported".into());
        };
        if pattern.subpat.is_some() {
            return Err("Command argument subpatterns are unsupported".into());
        }
        args.push(format!(
            "{}: {}",
            pattern.ident.to_string().to_lower_camel_case(),
            typescript(&arg.ty)?
        ));
    }
    let result = match &function.sig.output {
        ReturnType::Default => "null".into(),
        ReturnType::Type(_, ty) => {
            if let Ok((name, args)) = type_arguments(ty) {
                if name == "Result" {
                    let [ok, error] = args.as_slice() else {
                        return Err("Result needs two type arguments".into());
                    };
                    if typescript(error)? != "string" {
                        return Err("Only string IPC errors are supported".into());
                    }
                    typescript(ok)?
                } else {
                    typescript(ty)?
                }
            } else {
                typescript(ty)?
            }
        }
    };
    let args = if args.is_empty() {
        "undefined".into()
    } else {
        format!("{{ {} }}", args.join("; "))
    };
    Ok(format!(
        "  {}: {{ args: {args}; result: {result} }};\n",
        function.sig.ident
    ))
}

#[derive(Default)]
struct Calls {
    handlers: Vec<Vec<String>>,
    events: BTreeMap<String, String>,
    error: Option<String>,
}

fn is_emission(name: &str) -> bool {
    matches!(
        name,
        "emit" | "emit_to" | "emit_filter" | "emit_str" | "emit_str_to" | "emit_str_filter"
    )
}

impl<'ast> Visit<'ast> for Calls {
    fn visit_expr_call(&mut self, node: &'ast syn::ExprCall) {
        if let Expr::Path(function) = &*node.func {
            if function
                .path
                .segments
                .last()
                .is_some_and(|segment| is_emission(&segment.ident.to_string()))
            {
                self.error = Some("Unsupported event emission through a function call; use emit(\"literal-name\", ()) or extend the generator".into());
            }
        }
        syn::visit::visit_expr_call(self, node);
    }

    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        if name(&node.path) == "tauri::generate_handler" {
            let parsed =
                Punctuated::<Path, Token![,]>::parse_terminated.parse2(node.tokens.clone());
            match parsed {
                Ok(paths) if paths.iter().all(|p| p.get_ident().is_some()) => {
                    self.handlers.push(paths.iter().map(name).collect())
                }
                _ => {
                    self.error =
                        Some("Only direct command names in generate_handler are supported".into())
                }
            }
        }
        syn::visit::visit_macro(self, node);
    }

    fn visit_expr_method_call(&mut self, node: &'ast syn::ExprMethodCall) {
        if is_emission(&node.method.to_string()) {
            let args = node.args.iter().collect::<Vec<_>>();
            // Literal () establishes the actual Rust payload type. Arbitrary
            // expressions need type-aware support, so reject them explicitly.
            if node.method == "emit" {
                if let [Expr::Lit(event), Expr::Tuple(payload)] = args.as_slice() {
                    if let syn::Lit::Str(event) = &event.lit {
                        let event = event.value();
                        if payload.elems.is_empty()
                            && event
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || "-:/_".contains(c))
                        {
                            self.events.insert(event, "null".into());
                            syn::visit::visit_expr_method_call(self, node);
                            return;
                        }
                    }
                }
            }
            self.error = Some("Unsupported event emission; currently only emit(\"literal-name\", ()) is supported".into());
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn generate(main: &str, document: &str) -> Checked<String> {
    let main = syn::parse_file(main).map_err(|e| e.to_string())?;
    let document = syn::parse_file(document).map_err(|e| e.to_string())?;
    let document = document
        .items
        .iter()
        .find_map(|item| match item {
            Item::Struct(item) if item.ident == "Document" => Some(item),
            _ => None,
        })
        .ok_or("Missing Document struct")?;
    attributes(&document.attrs, &["derive", "doc"])?;
    let derives_serialize = document
        .attrs
        .iter()
        .filter(|a| a.path().is_ident("derive"))
        .any(|a| {
            a.parse_args_with(Punctuated::<Path, Token![,]>::parse_terminated)
                .is_ok_and(|paths| {
                    paths
                        .iter()
                        .any(|p| p.is_ident("Serialize") || name(p) == "serde::Serialize")
                })
        });
    if !derives_serialize || !document.generics.params.is_empty() {
        return Err("Document must derive Serialize without generic parameters".into());
    }
    let syn::Fields::Named(fields) = &document.fields else {
        return Err("Document must have named fields".into());
    };
    let mut output = "// Generated from Rust by pnpm generate:ipc. Do not edit.\n// Checked by pnpm check:ipc; this is not runtime payload validation.\ninterface RenderedDocument {\n".to_owned();
    for field in &fields.named {
        attributes(&field.attrs, &["doc"])?;
        output.push_str(&format!(
            "  {}: {};\n",
            field.ident.as_ref().unwrap(),
            typescript(&field.ty)?
        ));
    }
    output.push_str("}\n\ninterface ViewerCommands {\n");
    let mut commands = BTreeMap::new();
    for item in &main.items {
        if let Item::Fn(function) = item {
            if function
                .attrs
                .iter()
                .any(|a| name(a.path()) == "tauri::command")
            {
                commands.insert(function.sig.ident.to_string(), command(function)?);
            }
        }
    }
    let mut calls = Calls::default();
    calls.visit_file(&main);
    if let Some(error) = calls.error {
        return Err(error);
    }
    if calls.handlers.len() != 1 {
        return Err("Expected exactly one generate_handler registry".into());
    }
    for name in &calls.handlers[0] {
        output.push_str(
            &commands
                .remove(name)
                .ok_or_else(|| format!("Unrecognized or duplicate registered command: {name}"))?,
        );
    }
    if !commands.is_empty() {
        return Err(format!(
            "Commands missing from generate_handler: {:?}",
            commands.keys().collect::<Vec<_>>()
        ));
    }
    output.push_str("}\n\ninterface ViewerEvents {\n");
    for (event, payload) in calls.events {
        output.push_str(&format!("  '{event}': {payload};\n"));
    }
    output.push_str(&include_str!("../tauri-globals.d.ts").replace("\r\n", "\n"));
    Ok(output)
}

fn check(expected: &str, actual: &str) -> Checked<()> {
    // Git may check out CRLF on Windows; line endings do not change the contract.
    if expected.replace("\r\n", "\n") != actual.replace("\r\n", "\n") {
        return Err(
            "src/tauri.d.ts differs from Rust IPC. Run pnpm generate:ipc and commit the result."
                .into(),
        );
    }
    Ok(())
}

fn run() -> Checked<()> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let read = |path: &str| fs::read_to_string(root.join(path)).map_err(|e| format!("{path}: {e}"));
    let generated = generate(
        &read("src-tauri/src/main.rs")?,
        &read("src-tauri/src/document.rs")?,
    )?;
    match env::args().skip(1).collect::<Vec<_>>().as_slice() {
        [mode] if mode == "--write" => {
            fs::write(root.join("src/tauri.d.ts"), generated).map_err(|e| e.to_string())
        }
        [mode] if mode == "--check" => check(&generated, &read("src/tauri.d.ts")?),
        _ => Err("Usage: viewer-ipc-contract --check | --write".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("IPC contract: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const MAIN: &str = include_str!("../../../src-tauri/src/main.rs");
    const DOCUMENT: &str = include_str!("../../../src-tauri/src/document.rs");
    const TYPES: &str = include_str!("../../../src/tauri.d.ts");

    #[test]
    fn checked_in_contract_matches_actual_rust() {
        check(&generate(MAIN, DOCUMENT).unwrap(), TYPES).unwrap();
    }

    #[test]
    fn accepts_windows_line_endings_without_hiding_contract_drift() {
        let crlf = |source: &str| source.replace("\r\n", "\n").replace('\n', "\r\n");
        let main = crlf(MAIN);
        let document = crlf(DOCUMENT);
        let types = crlf(TYPES);
        check(&generate(&main, &document).unwrap(), &types).unwrap();
        assert!(check(
            &generate(
                &main,
                &document.replace("pub bytes: usize", "pub bytes: String")
            )
            .unwrap(),
            &types
        )
        .is_err());
    }

    #[test]
    fn detects_command_argument_result_and_registration_drift() {
        for main in [
            MAIN.replace("open_link", "browse_link"),
            MAIN.replace("href: String", "address: String"),
            MAIN.replace("-> f64", "-> String"),
            MAIN.replace("has_document: bool", "has_document: String"),
        ] {
            assert!(check(&generate(&main, DOCUMENT).unwrap(), TYPES).is_err());
        }
        let missing = MAIN.replacen("            open_link,", "", 1);
        assert!(generate(&missing, DOCUMENT)
            .unwrap_err()
            .contains("missing from"));
        let unknown = MAIN.replace("            open_link,", "            nonexistent,");
        assert!(generate(&unknown, DOCUMENT)
            .unwrap_err()
            .contains("Unrecognized"));
        assert!(TYPES.contains("hasDocument: boolean"));
        assert!(!TYPES.contains("app:"));
        assert!(!TYPES.contains("state:"));
    }

    #[test]
    fn detects_serialized_document_and_event_drift() {
        for document in [
            DOCUMENT.replace("pub name:", "pub title:"),
            DOCUMENT.replace("pub bytes: usize", "pub bytes: String"),
        ] {
            assert!(check(&generate(MAIN, &document).unwrap(), TYPES).is_err());
        }
        let main = MAIN.replace("\"file-pending\"", "\"document-pending\"");
        assert!(check(&generate(&main, DOCUMENT).unwrap(), TYPES).is_err());
        let main = MAIN.replace("emit(\"file-pending\", ())", "emit(\"file-pending\", true)");
        assert!(generate(&main, DOCUMENT)
            .unwrap_err()
            .contains("Unsupported event"));
    }

    #[test]
    fn rejects_additional_emission_forms_even_if_the_original_event_remains() {
        for emission in [
            "app.emit_str_filter(\"file-pending\", \"true\".into(), |_| true)",
            "Emitter::emit(&app, \"file-pending\", true)",
            "tauri::Emitter::emit(&app, \"file-pending\", true)",
        ] {
            let main = format!(
                "{MAIN}\nfn additional_event(app: tauri::AppHandle) {{ let _ = {emission}; }}"
            );
            assert!(
                generate(&main, DOCUMENT)
                    .unwrap_err()
                    .contains("Unsupported event"),
                "{emission}"
            );
        }
    }

    #[test]
    fn rejects_attributes_and_types_that_could_change_the_wire_contract() {
        for attribute in [
            "#[serde(rename = \"title\")]",
            "#[serde(skip)]",
            "#[serde(flatten)]",
            "#[cfg(windows)]",
        ] {
            let document =
                DOCUMENT.replace("    pub name:", &format!("    {attribute}\n    pub name:"));
            assert!(generate(MAIN, &document).is_err(), "{attribute}");
        }
        for attribute in ["#[serde(rename_all = \"camelCase\")]", "#[cfg(windows)]"] {
            let document = DOCUMENT.replace(
                "pub struct Document",
                &format!("{attribute}\npub struct Document"),
            );
            assert!(generate(MAIN, &document).is_err(), "{attribute}");
        }
        for attribute in [
            "#[tauri::command(rename_all = \"snake_case\")]",
            "#[tauri::command(rename = \"different\")]",
            "#[cfg(windows)]\n#[tauri::command]",
        ] {
            assert!(
                generate(&MAIN.replacen("#[tauri::command]", attribute, 1), DOCUMENT).is_err(),
                "{attribute}"
            );
        }
        assert!(generate(
            MAIN,
            &DOCUMENT.replace("pub bytes: usize", "pub bytes: CustomType")
        )
        .is_err());
        assert!(generate(
            &MAIN.replace("Result<(), String>", "Result<(), bool>"),
            DOCUMENT
        )
        .is_err());
    }
}
