import unittest
from scripts.interaction_language import resolve_prompt_language

class PromptLanguagePolicyTests(unittest.TestCase):
    def test_chinese_locales(self):
        for locale in ('zh', 'zh-CN', 'zh-TW', 'ZH_hans_CN'):
            self.assertEqual(resolve_prompt_language(locale), 'zh')
    def test_non_chinese_locales(self):
        for locale in ('en', 'th-TH', 'pt-BR', 'fr-FR', 'ja-JP', None):
            self.assertEqual(resolve_prompt_language(locale), 'en')

if __name__ == '__main__':
    unittest.main()
