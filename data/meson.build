configure_file(
  input: application_id + '.desktop.in',
  output: application_id + '.desktop',
  configuration: conf,
  install: true,
  install_dir: datadir / 'applications',
)

configure_file(
  input: application_id + '.appdata.xml.in',
  output: application_id + '.appdata.xml',
  configuration: conf,
  install: true,
  install_dir: datadir / 'metainfo',
)

install_data(
  application_id + '.gschema.xml',
  install_dir: datadir / 'glib-2.0' / 'schemas',
)

install_data(
  'icons/hicolor/scalable/apps/' + application_id + '.svg',
  install_dir: datadir / 'icons' / 'hicolor' / 'scalable' / 'apps',
)

gnome.compile_resources(
  'cusco-resources',
  application_id + '.gresource.xml',
  gresource_bundle: true,
  source_dir: meson.current_source_dir(),
  install: true,
  install_dir: pkgdatadir,
)
