// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "capri-mac-helper",
  platforms: [.macOS(.v11)],
  targets: [
    .executableTarget(name: "capri-mac-helper", path: "Sources/capri-mac-helper"),
  ]
)
