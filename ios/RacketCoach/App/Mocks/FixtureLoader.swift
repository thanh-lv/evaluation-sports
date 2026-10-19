import Foundation

/// Loads the JSON fixtures copied from `shared/fixtures` into `Resources/PreviewFixtures` (SwiftUI previews and
/// unit tests; stripped from archives through `DEVELOPMENT_ASSET_PATHS`) and `Resources/Samples` (the offline
/// sample analysis, shipped). `scripts/check_ios_resources.py` keeps the copies identical to the originals.
enum FixtureLoader {
    /// Bundles searched in order: the app, then any loaded test bundle.
    static var bundles: [Bundle] {
        var result = [Bundle.main]
        result.append(contentsOf: Bundle.allBundles.filter { $0 != Bundle.main })
        return result
    }

    static func url(named name: String, ext: String = "json") -> URL? {
        for bundle in bundles {
            if let url = bundle.url(forResource: name, withExtension: ext) { return url }
            for folder in ["PreviewFixtures", "Samples"] {
                if let url = bundle.url(forResource: name, withExtension: ext, subdirectory: folder) { return url }
            }
        }
        return nil
    }

    static func data(named name: String, ext: String = "json") -> Data? {
        guard let url = url(named: name, ext: ext) else { return nil }
        return try? Data(contentsOf: url)
    }

    static func decode<T: Decodable>(_ type: T.Type, named name: String) -> T? {
        guard let data = data(named: name) else { return nil }
        return try? JSONDecoder().decode(T.self, from: data)
    }
}
