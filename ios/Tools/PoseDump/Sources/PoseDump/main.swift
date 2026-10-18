import Foundation

// Entry point: `swift run -c release posedump clip.mov --skill bd.clear_fh [options]` (see README.md).
let status = await PoseDumpCommand.main(arguments: Array(CommandLine.arguments.dropFirst()))
exit(status)
