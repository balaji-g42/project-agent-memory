require_relative "rb2"
module M
  class Rb
    def go
      helper()
      self.stop
    end
    def stop; end
  end
end
def helper; end
