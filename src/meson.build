cusco_sources = files(
  'main.js',
  'application.js',
  'window.js',
)

install_data(
  cusco_sources,
  install_dir: pkgdatadir,
)

configure_file(
  input: 'cusco.in',
  output: 'cusco',
  configuration: conf,
  install: true,
  install_dir: bindir,
  install_mode: 'rwxr-xr-x',
)
