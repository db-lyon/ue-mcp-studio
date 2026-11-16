## v1.4.14-beta.5

Unreal Engine 5.4 to 5.9.

```bash
npx ue-mcp@beta
```

## Features

<details>
<summary><b>Editor dialogs</b></summary>

- `editor(list_dialogs)` reports a modal's drop-down pickers as `combos` (label, current value, `options`) and its editable text boxes as `textFields` (label, value, readOnly), alongside its buttons and tickable rows. A checkbox labelled from beside it, such as a details panel's bool property, carries that label as `fieldLabel`, and each choice says whether its button is `enabled`.
- `editor(respond_to_dialog)` takes `combos` [{index, option | optionIndex}] and `textFields` [{index, text}], applied through each widget's own selection and commit handlers before items and the button press, so the dialog's state really changes. A picker that does not end up showing the chosen option is an error and nothing is pressed. Fields can be set without a press, to read the dialog again first.
- A disabled button is refused instead of pressed, such as the DataTable Options dialog's Apply before a row type is chosen.

</details>

<details>
<summary><b>DataTables from CSV</b></summary>

- `asset(reimport_datatable)` and `asset(create_datatable)` take `csvString` or a `.csv` `filePath`, read through the engine's CSV importer with the DataTable Options dialog's `ignoreExtraFields`, `ignoreMissingFields` and `importKeyField`, and never raise the dialog. The importer's problems come back as `problems`.
- `asset(import_file)` imports a `.csv` into a DataTable with `rowStruct` (or the row struct of a DataTable already at the destination) and the same three options, without the dialog. An unattended `.csv` import with no row type is refused instead of producing nothing, and the importer's logged problems are returned as `problems`.

</details>
