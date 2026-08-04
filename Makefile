UUID := network-quality-ip@local
DIST_DIR := dist
ZIP := $(DIST_DIR)/$(UUID).shell-extension.zip
SCHEMA := schemas/org.gnome.shell.extensions.network-quality-ip.gschema.xml
MODULES := core.js pingMonitor.js ipService.js
JS_FILES := extension.js prefs.js $(MODULES) tests/test-core.js tests/test-ip-service.js tests/shell-smoke.js

.PHONY: all check smoke pack install clean

all: check pack

check:
	eslint $(JS_FILES)
	glib-compile-schemas --strict --dry-run schemas
	gjs -m tests/test-core.js
	gjs -m tests/test-ip-service.js

pack: $(ZIP)

smoke: pack
	dbus-run-session -- timeout 60 gnome-shell-test-tool \
		--headless --disable-animations --extension=$(ZIP) tests/shell-smoke.js

$(ZIP): metadata.json extension.js prefs.js stylesheet.css $(MODULES) $(SCHEMA)
	mkdir -p $(DIST_DIR)
	gnome-extensions pack . --force --out-dir=$(DIST_DIR) \
		--schema=$(SCHEMA) \
		$(foreach module,$(MODULES),--extra-source=$(module))

install: pack
	gnome-extensions install --force $(ZIP)
	@gnome-extensions enable $(UUID) || \
		echo "Installed. Log out and back in once, then run: gnome-extensions enable $(UUID)"

clean:
	rm -f $(ZIP)
