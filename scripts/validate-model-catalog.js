import Gio from 'gi://Gio?version=2.0';
import { BUNDLED_CATALOG, CATALOG_SCHEMA, CATALOG_OPTIONS } from '../src/providers/catalog.js';
import { validateCatalog, validateCatalogUpgrade } from '../packages/modelCatalog/validation.js';

validateCatalog(BUNDLED_CATALOG.data, CATALOG_SCHEMA, CATALOG_OPTIONS);
if (ARGV[0]) {
    const [, contents] = Gio.File.new_for_path(ARGV[0]).load_contents(null);
    const previous = JSON.parse(new TextDecoder().decode(contents));
    validateCatalogUpgrade(previous, BUNDLED_CATALOG.data);
}
print(`Cusco model catalog revision ${BUNDLED_CATALOG.revision} is valid`);
