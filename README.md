# glulxe-httpd

[![license](https://img.shields.io/github/license/statico/glulxe-httpd.svg?style=flat-square)](https://github.com/statico/glulxe-httpd/blob/master/LICENSE)
[![build status](https://img.shields.io/github/actions/workflow/status/statico/glulxe-httpd/build.yml?branch=main&style=flat-square)](https://ghcr.io/statico/glulxe-httpd)

glulxe-httpd provides an HTTP REST interface for interacting with interactive fiction (IF) stories in the [Glulx (`.ulx`) format](http://ifwiki.org/index.php/Glulx) using [glulxe](https://github.com/erkyrath/glulxe). Clients (like [my website](https://github.com/statico/langterm)) can connect to the service to start a game and then send commands to it.

Sessions are deleted after a while in a feeble attempt to save memory. This service is definitely DoS-able.

With the `--csv` option, transcripts of commands are saved to a CSV file. (I read what players type on my game to occasionally improve it.)

## Get Started

If you haven't spent many laborous hours writing an interactive fiction game with [Inform](http://inform7.com/), you can download one from the [Interactive Fiction Database](https://ifdb.tads.org/search?searchfor=format:Glulx%2fBlorb) or grab the classic _Adventure_ game as a `.ulx` file from [the Glulx page](https://www.eblong.com/zarf/glulx/index.html).

### With Docker

    $ docker run -p 8080:8080 -v mygame.ulx:/story.ulx ghcr.io/statico/glulxe-httpd

### With Node.js

1. Get Node.js v12 or so
1. Install Yarn
1. `yarn install`
1. `yarn start mygame.ulx`

## Sending Commands

First get a session ID:

    $ curl -X POST http://localhost:8080/new
    {
       "session": "xxxxxxx",
       "output": "Welcome to Adventure!\n\nADVENTURE..."
    }

Then send commands:

    $ curl -X POST http://localhost:8080/send \
    -H 'Content-type: application/json' \
    -d '{ "message": "look", "session": "xxxxxxx" }'
    {
       "output": "At End Of Road\nYou are standing at the end..."
    }

Pro tip: Run the server with `--debug` to always make the session ID `test`.

## See Also

I thought about running [Quixe](https://github.com/erkyrath/quixe) -- a Glulx interpreter written in JavaScript -- from within Node like I did with my original [Z8 server](https://github.com/statico/ifhttp). However, Quixe seems designed for the browser, not Node, and this just seemed a lot simpler.

These projects are good but don't support sessions and/or don't save transcripts:

- https://github.com/agentcox/glknode
- https://github.com/erkyrath/remote-if-demo

My original version of this used a Z-machine emulator for .z8 games: https://github.com/statico/ifhttp
