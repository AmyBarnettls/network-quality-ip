UUID := network-quality-ip@amybarnettls.github.io
DIST_DIR := dist
ZIP := $(DIST_DIR)/$(UUID).shell-extension.zip
JS_FILES := core.js extension.js
ACTUAL_JS_FILES := $(sort $(shell find . -path './.git' -prune -o -name '*.js' -print))

.PHONY: all check pack install clean

all: check pack

check:
	test "$(ACTUAL_JS_FILES)" = "./core.js ./extension.js"
	eslint --format unix $(JS_FILES)

pack: $(ZIP)

$(ZIP): metadata.json extension.js core.js stylesheet.css LICENSE
	mkdir -p $(DIST_DIR)
	gnome-extensions pack . --force --out-dir=$(DIST_DIR) \
		--extra-source=core.js \
		--extra-source=LICENSE

install: pack
	gnome-extensions install --force $(ZIP)
	@gnome-extensions enable $(UUID) || \
		echo "Installed. Log out and back in once, then enable $(UUID)"

clean:
	rm -f $(ZIP)
