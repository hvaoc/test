Pod::Spec.new do |s|
  s.name           = 'RecordNative'
  s.version        = '1.0.0'
  s.summary        = 'Native record-layer engine (gomobile-bound core/record).'
  s.description    = 'Bridges RecordMobile.xcframework to JS via an Expo module.'
  s.author         = 'app'
  s.homepage       = 'https://localhost'
  s.license        = 'MIT'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # The gomobile-bound Go record engine.
  s.vendored_frameworks = 'RecordMobile.xcframework'

  s.source_files = '**/*.{h,m,swift}'
end
