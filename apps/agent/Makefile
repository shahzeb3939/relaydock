.PHONY: build test test-race cross-build format format-check clean

build:
	mkdir -p bin
	go build -trimpath -o bin/relaydock-agent .

test:
	go test ./...

test-race:
	go test -race ./...

cross-build:
	mkdir -p bin
	GOOS=darwin GOARCH=arm64 go build -trimpath -o bin/relaydock-agent-darwin-arm64 .
	GOOS=linux GOARCH=amd64 go build -trimpath -o bin/relaydock-agent-linux-amd64 .
	GOOS=windows GOARCH=amd64 go build -trimpath -o bin/relaydock-agent-windows-amd64.exe .

format:
	gofmt -w .

format-check:
	@test -z "$$(gofmt -l .)" || (gofmt -l . && exit 1)

clean:
	rm -rf bin
