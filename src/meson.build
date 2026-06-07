cusco_sources = files(
  'main.js',
  'application.js',
  'window.js',
)

provider_sources = files(
  'providers/provider.js',
  'providers/mockProvider.js',
)

install_data(
  cusco_sources,
  install_dir: pkgdatadir,
)

install_data(
  provider_sources,
  install_dir: pkgdatadir / 'providers',
)

configure_file(
  input: 'cusco.in',
  output: 'cusco',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)
