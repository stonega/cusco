# Project templates

Use these as starting points for GNOME Shell 45 and later. Replace every
placeholder and verify all imported Shell modules against the target major.

## Minimal layout

```text
example@developer.invalid/
├── extension.js
├── metadata.json
├── prefs.js                 # optional
├── stylesheet.css           # optional
└── schemas/                 # optional
    └── org.gnome.shell.extensions.example.gschema.xml
```

The extension directory and packaged UUID must match `metadata.json` exactly.

## `metadata.json`

```json
{
  "uuid": "example@developer.invalid",
  "name": "Example Extension",
  "description": "Describe one user-visible behavior.",
  "shell-version": ["<TESTED_SHELL_MAJOR>"],
  "url": "https://example.invalid/example-extension",
  "settings-schema": "org.gnome.shell.extensions.example"
}
```

Remove `settings-schema` when the extension has no schema. Replace the target
major with versions actually tested; the placeholder is not a compatibility
claim.

## Panel indicator `extension.js`

```javascript
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export default class ExampleExtension extends Extension {
    enable() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, false);
        this._indicator.add_child(new St.Icon({
            icon_name: 'applications-development-symbolic',
            style_class: 'system-status-icon',
        }));

        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
```

Add functionality inside owned components rather than growing the entry point
indefinitely. Every signal, timeout, binding, subscription, and async request
introduced by the feature needs a visible cleanup path.

## `prefs.js`

```javascript
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class ExamplePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const page = new Adw.PreferencesPage({
            title: _('General'),
            icon_name: 'preferences-system-symbolic',
        });
        const group = new Adw.PreferencesGroup({
            title: _('Behavior'),
        });
        const row = new Adw.SwitchRow({
            title: _('Show Indicator'),
        });

        group.add(row);
        page.add(group);
        window.add(page);

        window._settings = this.getSettings();
        window._settings.bind(
            'show-indicator',
            row,
            'active',
            Gio.SettingsBindFlags.DEFAULT,
        );
    }
}
```

Preferences are a separate process. Do not import `St`, `Clutter`, `Meta`,
`Shell`, or Shell UI modules here.

## GSettings schema

```xml
<?xml version="1.0" encoding="UTF-8"?>
<schemalist>
  <schema id="org.gnome.shell.extensions.example"
          path="/org/gnome/shell/extensions/example/">
    <key name="show-indicator" type="b">
      <default>true</default>
      <summary>Show the panel indicator</summary>
    </key>
  </schema>
</schemalist>
```

Keep the schema filename equal to its ID plus `.gschema.xml`. Compile it with:

```sh
glib-compile-schemas --strict schemas
```

## Legacy targets

Do not mechanically translate the templates to `imports.*` inside the same
entry point. If GNOME Shell 44 or earlier is required, read the matching legacy
guide and maintain a distinct build output or release branch across the ESM
boundary.

## Official references

- <https://gjs.guide/extensions/overview/anatomy.html>
- <https://gjs.guide/extensions/overview/imports-and-modules.html>
- <https://gjs.guide/extensions/development/preferences.html>
