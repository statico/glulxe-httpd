.PHONY: build test

build:
	docker build . --tag glulxe-httpd

test:
	./test/test.sh

