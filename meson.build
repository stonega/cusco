project(
  'cusco',
  'c',
  version: '0.5.9',
  license: 'GPL-3.0-or-later',
  meson_version: '>= 0.62.0',
)

gnome = import('gnome')

application_id = 'io.github.stonega.Cusco'
prefix = get_option('prefix')
bindir = prefix / get_option('bindir')
datadir = prefix / get_option('datadir')
pkgdatadir = datadir / meson.project_name()

conf = configuration_data()
conf.set('APP_ID', application_id)
conf.set('VERSION', meson.project_version())
conf.set('PKGDATADIR', pkgdatadir)

subdir('src')
subdir('data')

gnome.post_install(
  glib_compile_schemas: true,
  gtk_update_icon_cache: true,
  update_desktop_database: true,
)
