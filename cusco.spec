Name:           cusco
Version:        0.5.32
Release:        2%{?dist}
Summary:        Native AI desktop workspace for GNOME

License:        GPL-3.0-or-later
URL:            https://github.com/stonega/cusco
Source0:        %{url}/archive/refs/tags/v%{version}/%{name}-%{version}.tar.gz

BuildArch:      noarch

BuildRequires:  appstream
BuildRequires:  desktop-file-utils
BuildRequires:  gcc
BuildRequires:  glib2-devel
BuildRequires:  gtk4
BuildRequires:  meson

# GJS gi:// imports are not handled by RPM's automatic dependency generator.
Requires:       at-spi2-core
Requires:       gdk-pixbuf2
Requires:       gjs
Requires:       gnome-shell
Requires:       gtk4
Requires:       gtksourceview5
Requires:       hicolor-icon-theme
Requires:       libadwaita
Requires:       libsecret
Requires:       libsoup3
Requires:       webkitgtk6.0

%description
Cusco is a native GNOME AI chat application built with GJS, GTK 4, and the
Adwaita platform library. It provides persistent conversations, multiple AI
providers, controlled memory, local tools, reusable workspace assets, and
GNOME desktop integration.

%prep
%autosetup -n cusco-%{version}

%build
%meson
%meson_build

%install
%meson_install
sed -i '1{/^#!/d}' %{buildroot}%{_datadir}/cusco/main.js

%check
desktop-file-validate \
  %{buildroot}%{_datadir}/applications/io.github.stonega.Cusco.desktop
appstreamcli validate --no-net \
  %{buildroot}%{_datadir}/metainfo/io.github.stonega.Cusco.appdata.xml

%files
%license LICENSE
%doc CHANGELOG.md README.md
%{_bindir}/cusco
%{_datadir}/applications/io.github.stonega.Cusco.desktop
%{_datadir}/cusco/
%{_datadir}/glib-2.0/schemas/io.github.stonega.Cusco.gschema.xml
%{_datadir}/gnome-shell/extensions/cusco-computer-use@stonega/
%{_datadir}/gnome-shell/search-providers/io.github.stonega.Cusco.search-provider.ini
%{_datadir}/icons/hicolor/*/apps/io.github.stonega.Cusco.png
%{_datadir}/metainfo/io.github.stonega.Cusco.appdata.xml

%changelog
* Tue Aug 04 2026 stone <xijieyin@gmail.com> - 0.5.32-2
- Add the GTK build dependency required by the Meson GNOME install hook

* Tue Aug 04 2026 stone <xijieyin@gmail.com> - 0.5.32-1
- Initial Fedora COPR package
