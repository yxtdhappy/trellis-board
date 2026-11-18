use super::*;

#[test]
fn loads_document_with_default_schema() {
    let document = load_client_document();
    assert!(document.is_object());
}
