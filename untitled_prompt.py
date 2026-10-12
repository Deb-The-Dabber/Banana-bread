from google import genai
from google.genai import types
import base64
import os

def generate():
  client = genai.Client(
      vertexai=True,
      api_key=os.environ.get("GOOGLE_CLOUD_API_KEY"),
  )


  model = "gemini-3.1-flash-image"
  contents = [
    types.Content(
      role="user",
      parts=[
      ]
    )
  ]

  generate_content_config = types.GenerateContentConfig(
    temperature = 1,
    top_p = 0.95,
    max_output_tokens = 32768,
    response_modalities = ["TEXT", "IMAGE"],
    safety_settings = [types.SafetySetting(
      category="HARM_CATEGORY_IMAGE_HATE",
      threshold="OFF"
    ),types.SafetySetting(
      category="HARM_CATEGORY_IMAGE_DANGEROUS_CONTENT",
      threshold="OFF"
    ),types.SafetySetting(
      category="HARM_CATEGORY_IMAGE_HARASSMENT",
      threshold="OFF"
    ),types.SafetySetting(
      category="HARM_CATEGORY_IMAGE_SEXUALLY_EXPLICIT",
      threshold="OFF"
    )],
    image_config=types.ImageConfig(
      aspect_ratio="auto",
      image_size="1K",
      output_mime_type="image/png",
    ),
    thinking_config=types.ThinkingConfig(
      thinking_level="MINIMAL",
    ),
  )

  for chunk in client.models.generate_content_stream(
    model = model,
    contents = contents,
    config = generate_content_config,
    ):
    print(chunk.text, end="")

generate()