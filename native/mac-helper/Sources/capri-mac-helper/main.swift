// What windows.ps1 and the PowerShell in apps.js do on Windows, for macOS.
//
//   capri-mac-helper watch <capri window id> <capri pid>
//     One JSON line whenever something changes: the frontmost window and the visible windows in
//     z-order (front first), as frame bounds in points. No titles, no contents (so no Screen
//     Recording permission needed).
//   capri-mac-helper apps
//     The running apps (the ones with a Dock icon), as JSON.
//   capri-mac-helper quit [--force] <pid>...
//     Quits them like ⌘Q would (they can still ask to save), or ends them outright with --force.
//     Prints how many are still running afterwards.

import AppKit
import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func json(_ value: Any) -> String {
  let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("null".utf8)
  return String(decoding: data, as: UTF8.self)
}

func isRunning(_ pid: Int32) -> Bool {
  kill(pid, 0) == 0 || errno == EPERM
}

// AppKit's screens have their origin bottom-left; CoreGraphics (and Electron) top-left of the main one.
func visibleFrames() -> [CGRect] {
  guard let main = NSScreen.screens.first else { return [] }
  let height = main.frame.height
  return NSScreen.screens.flatMap { screen -> [CGRect] in
    let flip = { (r: NSRect) in CGRect(x: r.minX, y: height - r.maxY, width: r.width, height: r.height) }
    return [flip(screen.visibleFrame), flip(screen.frame)]
  }
}

// macOS has no "maximized": a window that fills a screen's usable area (or the whole screen) counts.
func fills(_ r: CGRect, _ frames: [CGRect]) -> Bool {
  frames.contains { f in
    abs(r.minX - f.minX) <= 4 && abs(r.minY - f.minY) <= 4 && abs(r.width - f.width) <= 8 && abs(r.height - f.height) <= 8
  }
}

let SKIP_OWNERS: Set<String> = ["Window Server", "Dock", "SystemUIServer", "Control Center", "Notification Center"]

func snapshot(selfId: Int) -> String {
  let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
  let list = (CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]) ?? []
  let frontPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
  let frames = visibleFrames()
  var fg = 0
  var firstNormal = 0
  var wins: [[String: Any]] = []
  for info in list {
    guard (info[kCGWindowLayer as String] as? Int) == 0,
          let id = info[kCGWindowNumber as String] as? Int, id != selfId,
          let boundsDict = info[kCGWindowBounds as String] as? NSDictionary,
          let r = CGRect(dictionaryRepresentation: boundsDict as CFDictionary) else { continue }
    if let owner = info[kCGWindowOwnerName as String] as? String, SKIP_OWNERS.contains(owner) { continue }
    if let alpha = info[kCGWindowAlpha as String] as? Double, alpha < 0.05 { continue }
    let pid = (info[kCGWindowOwnerPID as String] as? Int32) ?? 0
    if firstNormal == 0 { firstNormal = id }
    if fg == 0 && pid == frontPid { fg = id }
    if r.width < 200 || r.height < 120 || wins.count >= 40 { continue }
    wins.append([
      "id": id, "x": Int(r.minX.rounded()), "y": Int(r.minY.rounded()),
      "w": Int(r.width.rounded()), "h": Int(r.height.rounded()), "max": fills(r, frames),
    ])
  }
  return json(["fg": fg != 0 ? fg : firstNormal, "wins": wins])
}

func watch(selfId: Int, parentPid: Int32) -> Never {
  _ = NSApplication.shared
  NSApp.setActivationPolicy(.prohibited)
  var last = ""
  // a run loop rather than a sleep loop: NSWorkspace only learns which app is in front through it
  Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
    // stop with Capri, even if she crashed without telling us
    if parentPid > 0 && !isRunning(parentPid) { exit(0) }
    let snap = snapshot(selfId: selfId)
    if snap != last {
      print(snap)
      last = snap
    }
  }
  RunLoop.main.run()
  exit(0)
}

func apps() {
  let me = ProcessInfo.processInfo.processIdentifier
  let rows: [[String: Any]] = NSWorkspace.shared.runningApplications.compactMap { app in
    guard app.activationPolicy == .regular, app.processIdentifier != me, !app.isTerminated else { return nil }
    let label = app.localizedName ?? ""
    let name = app.bundleURL?.deletingPathExtension().lastPathComponent ?? label
    return ["id": Int(app.processIdentifier), "name": name, "label": label, "bundle": app.bundleIdentifier ?? ""]
  }
  print(json(rows))
}

func quit(pids: [Int32], force: Bool) {
  for pid in pids {
    guard let app = NSRunningApplication(processIdentifier: pid) else { continue }
    _ = force ? app.forceTerminate() : app.terminate()
  }
  // give them time to close (or to ask about unsaved work)
  let deadline = Date().addingTimeInterval(force ? 0.6 : 2.5)
  while Date() < deadline && pids.contains(where: isRunning) {
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
  }
  print(pids.filter(isRunning).count)
}

var args = Array(CommandLine.arguments.dropFirst())
let command = args.isEmpty ? "" : args.removeFirst()
switch command {
case "watch":
  watch(selfId: Int(args.first ?? "") ?? 0, parentPid: Int32(args.dropFirst().first ?? "") ?? 0)
case "apps":
  apps()
case "quit":
  let force = args.contains("--force")
  quit(pids: args.compactMap { Int32($0) }, force: force)
default:
  FileHandle.standardError.write(Data("usage: capri-mac-helper watch <window id> <pid> | apps | quit [--force] <pid>...\n".utf8))
  exit(2)
}
