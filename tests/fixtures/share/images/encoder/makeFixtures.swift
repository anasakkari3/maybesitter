// macOS (#404): writes GPS-tagged HEIC and JPEG camera-like photos through ImageIO, with an embedded
// thumbnail, EXIF orientation 6, a TIFF owner/serial, an EXIF comment and an IPTC caption, every
// text value marked HIDDEN-*. `swiftc -O makeFixtures.swift -o makeFixtures`, then
//   ./makeFixtures 96 72 imageio-gps.heic
//   ./makeFixtures 240 180 imageio-camera-gps-thumbnail.jpg
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

func makeImage(width: Int, height: Int) -> CGImage {
  let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(red: 1, green: 1, blue: 0.9, alpha: 1)
  ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
  // Stripes and blocks so the encoder has real detail, and an asymmetric mark to see orientation.
  var seed: UInt32 = 12345
  for i in 0..<(width * height > 100_000 ? 400 : 12) {
    seed = seed &* 1103515245 &+ 12345
    let x = Int(seed % UInt32(width)); let y = Int((seed >> 8) % UInt32(height))
    ctx.setFillColor(red: CGFloat(i % 7) / 7, green: CGFloat(i % 5) / 5, blue: CGFloat(i % 3) / 3, alpha: 1)
    ctx.fill(CGRect(x: x, y: y, width: 40 + i % 90, height: 12 + i % 30))
  }
  ctx.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
  ctx.fill(CGRect(x: 0, y: height - height / 5, width: width / 5, height: height / 5)) // top-left red block
  return ctx.makeImage()!
}

func write(_ image: CGImage, to path: String, type: UTType) {
  let url = URL(fileURLWithPath: path)
  let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
  let props: [CFString: Any] = [
    kCGImageDestinationEmbedThumbnail: true,
    kCGImageDestinationLossyCompressionQuality: 0.9,
    kCGImagePropertyOrientation: 6, // camera held in portrait: pixels need a 90° turn to display
    kCGImagePropertyGPSDictionary: [
      kCGImagePropertyGPSLatitude: 32.0853, kCGImagePropertyGPSLatitudeRef: "N",
      kCGImagePropertyGPSLongitude: 34.7818, kCGImagePropertyGPSLongitudeRef: "E",
      kCGImagePropertyGPSAltitude: 41.5,
      kCGImagePropertyGPSAreaInformation: "HIDDEN-GPS-AREA Dana home",
      kCGImagePropertyGPSProcessingMethod: "HIDDEN-GPS-METHOD",
    ],
    kCGImagePropertyTIFFDictionary: [
      kCGImagePropertyTIFFMake: "Apple", kCGImagePropertyTIFFModel: "iPhone 15 HIDDEN-SERIAL",
      kCGImagePropertyTIFFArtist: "HIDDEN-OWNER Dana Levy",
    ],
    kCGImagePropertyExifDictionary: [
      kCGImagePropertyExifUserComment: "HIDDEN-EXIF-COMMENT", kCGImagePropertyExifDateTimeOriginal: "2026:09:01 08:30:00",
    ],
    kCGImagePropertyIPTCDictionary: [ kCGImagePropertyIPTCCaptionAbstract: "HIDDEN-IPTC-CAPTION" ],
  ]
  CGImageDestinationAddImage(dest, image, props as CFDictionary)
  precondition(CGImageDestinationFinalize(dest), "finalize failed for \(path)")
}

let args = CommandLine.arguments
if args.count > 1 {
  // makeFixtures <width> <height> <out.heic|out.jpg>
  let w = Int(args[1])!, h = Int(args[2])!, out = args[3]
  write(makeImage(width: w, height: h), to: out, type: out.hasSuffix(".heic") ? .heic : .jpeg)
} else {
  let img = makeImage(width: 4032, height: 3024)
  write(img, to: "camera_gps.heic", type: .heic)
  write(img, to: "camera_gps.jpg", type: .jpeg)
}
print("ok")
