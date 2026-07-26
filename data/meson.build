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
  application_id + '.search-provider.ini',
  install_dir: datadir / 'gnome-shell' / 'search-providers',
)

install_subdir(
  'gnome-shell/extensions/cusco-computer-use@stonega',
  install_dir: datadir / 'gnome-shell' / 'extensions',
)

app_icon_file = application_id + '.png'
foreach icon_size : ['64x64', '128x128', '256x256', '512x512']
  install_data(
    'icons' / 'hicolor' / icon_size / 'apps' / app_icon_file,
    install_dir: datadir / 'icons' / 'hicolor' / icon_size / 'apps',
  )
endforeach

install_subdir(
  'resources',
  install_dir: pkgdatadir,
)

install_data(
  '../assets/machupicchu_dark.png',
  '../assets/machupicchu_light.png',
  install_dir: pkgdatadir / 'resources',
)

gnome.compile_resources(
  'cusco-resources',
  application_id + '.gresource.xml',
  gresource_bundle: true,
  source_dir: meson.current_source_dir(),
  install: true,
  install_dir: pkgdatadir,
)
